import { StrictMode, act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { runtimeId, sessionId, sessionKey } from '@harnessdesk/protocol'
import type { SettingsRoute } from '../state/destinations'

const native = vi.hoisted(() => ({run: (_action: string) => {}}))
vi.mock('../lib/desktop', () => ({ desktop: () => undefined, isDesktop: () => false,
  onOpenGoal: () => () => {}, onOpenSession: () => () => {}, onShortcut: (run: (action:string)=>void) => { native.run=run; return () => {} }, setTraySummary: () => {}, setWindowTitle: () => {} }))
vi.mock('../panels/Workbench', () => ({ Workbench: ({sidebar, pages, pageActive}: {sidebar:ReactNode;pages:ReactNode;pageActive:boolean}) =>
  <>{sidebar}<div data-slot="retained-work" hidden={pageActive} inert={pageActive}><input defaultValue="Remembered draft" /></div>{pages}</> }))
vi.mock('../components/Sidebar', () => ({ Sidebar: (props: Record<string, unknown>) => <div data-sidebar>
  {['Settings','Agents','Teams','Customize','Dashboard'].map((label, at) => <button key={label} onClick={() =>
    (props[['onOpenSettings','onOpenAgents','onOpenTeams','onOpenLibrary','onOpenUsage'][at]!] as () => void)()}>{label}</button>)}
  <output data-selected>{String(props.activeDestination ?? '')}</output><output data-settings>{JSON.stringify(props.settings ? (props.settings as {section:string}).section : null)}</output>
</div> }))
vi.mock('../components/FrontDoor', () => ({ FrontDoor: () => <output data-new-team /> }))
vi.mock('../components/Notices', () => ({ Notices: () => null }))
vi.mock('../components/CommandPalette', () => ({ CommandPalette: () => <output data-testid="command-palette" /> }))
vi.mock('../components/ImportOffer', () => ({ ImportOffer: () => null }))
vi.mock('../design', async importOriginal => ({...await importOriginal<object>(), Toaster: () => null}))
vi.mock('../state/theme', () => ({ useTheme: () => 'light' }))
vi.mock('../components/Settings', async importOriginal => {
  const { useShell } = await import('../panels/views')
  const { useDestinationActive } = await import('../panels/destination-page')
  return { ...await importOriginal<object>(), Settings: ({ route }: {route:SettingsRoute}) => {
    const shell = useShell(), active = useDestinationActive()
    return <div><output data-settings-route>{JSON.stringify(route)}</output><output data-active>{String(active)}</output>
      <input aria-label="Search settings" defaultValue="" /><button onClick={() => shell.openAgents('fixture-reviewer')}>Open its Agent</button><button onClick={shell.reviewImports}>Review imports</button></div>
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
for (const kind of ['dashboard','agents','teams','library'] as const) it(`all normal ${kind} doors use registration, normal selection and real Back/Forward`, async () => {
  const label = {dashboard:'Dashboard',agents:'Agents',teams:'Teams',library:'Customize'}[kind]
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
it('Escape leaves Settings in one step while Command-W still returns to retained work', async () => {
  const store = routedStore('/synthetic/project')
  await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
  const escape = new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})
  act(() => window.dispatchEvent(escape))
  expect(escape.defaultPrevented).toBe(true)
  await settle()
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
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

it('native usage links open the named runtime and remain open when chosen again', async () => {
  const previous = MAIN_PAGE_ENTRIES.dashboard
  MAIN_PAGE_ENTRIES.dashboard = ({ page }) => <output>{page.kind}</output>
  try {
    const store = routedStore()
    await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
    for (let repeat = 0; repeat < 2; repeat++) {
      act(() => native.run('open-usage:fixture-runtime'))
      expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'dashboard', view: 'plans', scope: 'fixture-runtime' })
    }
    act(() => native.run('open-usage'))
    expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'dashboard', view: 'overview', scope: null })
  } finally { MAIN_PAGE_ENTRIES.dashboard = previous }
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
    await click('Customize')
    expect(container.querySelector('[data-import-intent]')?.textContent).toBe('0')
  } finally { MAIN_PAGE_ENTRIES.library = previous }
})

it('opens the column Settings mode from Command-comma', async () => {
  const store = routedStore('')
  await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
  const event = new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true })
  act(() => document.dispatchEvent(event)); await settle()
  expect(event.defaultPrevented).toBe(true)
  expect(store.getSnapshot().workbench.navigation.current).toEqual({kind:'settings',route:{kind:'section',section:'general',focus:null}})
  expect(container.querySelector('[data-settings]')?.textContent).toBe(JSON.stringify('general'))
})

it('opens the command palette from Search in the hidden-column top row', async () => {
  await act(async () => root.render(<StoreProvider store={routedStore('')}><App /></StoreProvider>))
  expect(container.querySelector('[data-testid="command-palette"]')).toBeNull()
  act(() => window.dispatchEvent(new Event('harnessdesk:search')))
  expect(container.querySelector('[data-testid="command-palette"]')).not.toBeNull()
})

it('New Team keeps its main page behind the dialog', async () => {
  const previous = MAIN_PAGE_ENTRIES.plugins
  MAIN_PAGE_ENTRIES.plugins = () => <output>Plugins</output>
  try {
    const store = routedStore()
    Object.assign(store.getSnapshot(), { workspace: {path:'/work/project',name:'Synthetic project'} })
    await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
    act(() => store.openDestination({kind:'plugins',section:'installed',id:null}))
    act(() => native.run('new-team'))
    expect(store.getSnapshot().workbench.navigation.current).toEqual({kind:'plugins',section:'installed',id:null})
    expect(container.querySelector('[data-page-destination="plugins"]')?.hasAttribute('hidden')).toBe(false)
    expect(container.querySelector('[data-new-team]')).not.toBeNull()
  } finally { MAIN_PAGE_ENTRIES.plugins = previous }
})
for (const kind of ['library','plugins','dashboard'] as const) it(`Escape returns from the former ${kind} window page`, async () => {
  const previous = MAIN_PAGE_ENTRIES[kind]
  MAIN_PAGE_ENTRIES[kind] = () => <output>Page</output>
  try {
    const store = routedStore()
    await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
    const page = kind === 'library' ? {kind,section:'skill' as const} : kind === 'plugins' ? {kind,section:'installed' as const,id:null} : {kind,view:'overview' as const,scope:null}
    act(() => store.openDestination(page))
    const handled = new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})
    handled.preventDefault()
    act(() => window.dispatchEvent(handled))
    expect(store.getSnapshot().workbench.navigation.current.kind).toBe(kind)
    const escape = new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})
    act(() => window.dispatchEvent(escape))
    expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
    expect(escape.defaultPrevented).toBe(true)
  } finally { MAIN_PAGE_ENTRIES[kind] = previous }
})

for (const editable of ['input', 'textarea', 'contenteditable'] as const) it(`Escape leaves nonempty ${editable} editing on the page`, async () => {
  const store = routedStore('/synthetic/project')
  await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
  const field = document.createElement(editable === 'contenteditable' ? 'div' : editable)
  if (editable === 'contenteditable') { field.setAttribute('contenteditable', 'true'); field.textContent = 'Edited query' }
  else (field as HTMLInputElement).value = 'Edited query'
  container.append(field)
  const before = store.getSnapshot().workbench.navigation
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => field.dispatchEvent(escape)); await settle()
  expect(store.getSnapshot().workbench.navigation).toBe(before)
  expect(escape.defaultPrevented).toBe(false)
})
it('Escape during IME composition does not leave the page', async () => {
  const store = routedStore('/synthetic/project')
  await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
  const before = store.getSnapshot().workbench.navigation
  const escape = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
  act(() => window.dispatchEvent(escape)); await settle()
  expect(store.getSnapshot().workbench.navigation).toBe(before)
})

it('Escape from an inactive retained editor still leaves Settings', async () => {
  const store = routedStore('/synthetic/project')
  await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
  await settle()
  const retained = container.querySelector<HTMLInputElement>('[data-slot="retained-work"] input')!
  expect(retained.value).not.toBe('')
  expect(retained.closest('[inert]')).not.toBeNull()
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => retained.dispatchEvent(escape)); await settle()
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
})


it('Command-G toggles an existing conversation from an input and shares the native action', async () => {
  const store = routedStore(), key = sessionKey(runtimeId('demo'), sessionId('mode-session'))
  Object.assign(store.getSnapshot(), { sessions: new Map([[key, { title: 'Synthetic conversation', turns: [] }]]) })
  store.selectWork({ kind: 'conversation', session: key })
  await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
  const field = container.querySelector('input')!
  field.focus()
  const chord = () => new KeyboardEvent('keydown', { key: 'g', metaKey: true, bubbles: true, cancelable: true })
  const first = chord()
  act(() => field.dispatchEvent(first))
  expect(first.defaultPrevented).toBe(true)
  expect(store.getSnapshot().windowMode).toBe('editor')
  act(() => native.run('toggle-editor-mode'))
  expect(store.getSnapshot().windowMode).toBe('conversation')
  await settle()
  const handled = chord(); handled.preventDefault()
  act(() => field.dispatchEvent(handled))
  expect(store.getSnapshot().windowMode).toBe('conversation')
  const recency = store.getSnapshot().editorState
  expect(recency[0]?.subject).toBe(`session:${key}`)
  const next = sessionKey(runtimeId('demo'), sessionId('next-session'))
  Object.assign(store.getSnapshot(), { sessions: new Map([...store.getSnapshot().sessions, [next, { title: 'Next conversation', turns: [] } as never]]) })
  act(() => store.selectWork({ kind: 'conversation', session: next }))
  await settle()
  expect(store.getSnapshot().editorState[0]?.subject).toBe(`session:${next}`)
})

for (const current of [
  { kind: 'work' as const, view: { kind: 'conversation' as const, session: null } },
  { kind: 'work' as const, view: { kind: 'room' as const, room: 'demo-team' } },
  { kind: 'settings' as const, route: { kind: 'section' as const, section: 'general' as const, focus: null } },
  { kind: 'teams' as const, filter: 'active' as const },
]) it(`Command-G and native mode commands leave the preference alone on ${JSON.stringify(current)}`, async () => {
  const store = routedStore()
  store.setWindowMode('editor')
  const workbench = store.getSnapshot().workbench
  Object.assign(store.getSnapshot(), { workbench: { ...workbench, navigation: { ...workbench.navigation, current } } })
  await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
  const change = vi.spyOn(store, 'setWindowMode'), touch = vi.spyOn(store, 'touchEditorConversation')
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', metaKey: true, bubbles: true, cancelable: true })))
  act(() => native.run('toggle-editor-mode'))
  expect(change).not.toHaveBeenCalled()
  expect(touch).not.toHaveBeenCalled()
  expect(store.getSnapshot().windowMode).toBe('editor')
})
it('Go to file only dispatches for Editor on a conversation, using Command and Control aliases', async () => {
  const store = routedStore(), key = sessionKey(runtimeId('demo'), sessionId('file-session'))
  Object.assign(store.getSnapshot(), { sessions: new Map([[key, { title: 'Synthetic conversation', turns: [] }]]) })
  store.selectWork({ kind: 'conversation', session: key })
  const open = vi.fn()
  window.addEventListener('harnessdesk:go-to-file', open)
  try {
    await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
    act(() => native.run('go-to-file'))
    expect(open).not.toHaveBeenCalled()
    act(() => store.setWindowMode('editor'))
    for (const modifier of ['metaKey', 'ctrlKey']) act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', [modifier]: true, bubbles: true, cancelable: true })))
    expect(open).toHaveBeenCalledTimes(2)
    await click('Settings')
    act(() => native.run('go-to-file'))
    expect(open).toHaveBeenCalledTimes(2)
  } finally { window.removeEventListener('harnessdesk:go-to-file', open) }
})


it('native Skills requests open Customize scoped to the current runtime, including repeated requests', async () => {
  const previous = MAIN_PAGE_ENTRIES.library
  MAIN_PAGE_ENTRIES.library = () => <output data-customize />
  try {
    const store = routedStore()
    Object.assign(store.getSnapshot(), { activeRuntime: runtimeId('one') })
    await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
    for (const id of ['one', 'two']) {
      Object.assign(store.getSnapshot(), { activeRuntime: runtimeId(id) })
      await act(async () => store.askSettings('skills')); await settle(); await settle()
      expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'library', section: 'skill' })
      expect(store.libraryView('skill').runtime).toBe(id)
    }
  } finally { MAIN_PAGE_ENTRIES.library = previous }
})

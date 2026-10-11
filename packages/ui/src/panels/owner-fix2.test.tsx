import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sessionKey, runtimeId, sessionId, type BackgroundTask } from '@harnessdesk/protocol'
import { MenuItem } from '../design'
import { StoreProvider, PaneProvider } from '../state/context'
import { previewStore, PREVIEW_SESSION_KEY } from '../preview/harness'
import { Sidebar } from '../components/Sidebar'
import { WorkActivityView } from '../components/WorkToolContents'
import { WorkTools } from './WorkTools'
import { TopBarProvider, TopBarOutlet, useTopBar } from './top-bar'
import { ShellHostsProvider, ShellOutlets, useShellHosts } from './shell-hosts'
import { shortcutFor, chordOf } from '../lib/shortcuts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks() })
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button,[role="menuitem"]')].find(node => node.textContent?.includes(label))!
const task = (id: string, state: BackgroundTask['state'] = 'running'): BackgroundTask => ({ id, label: id, kind: 'command', state, command: 'node review.mjs', output: 'Recorded output', cwd: '/work/storefront', stoppable: true })
const sidebarProps = { onOpenSettings: () => {}, onOpenPlugins: () => {}, onOpenAgents: () => {}, onOpenTeams: () => {}, onOpenUsage: vi.fn(), onBrowseFolders: () => {}, onSignIn: vi.fn(), onSearch: () => {} }
it('seat menu owns every plan and scoped Open usage actions', async () => {
  const store = previewStore()
  await act(async () => root.render(<StoreProvider store={store}><Sidebar {...sidebarProps} /></StoreProvider>))
  act(() => host.querySelector<HTMLButtonElement>('[data-left-seat] [data-slot="popover-trigger"]')!.click())
  act(() => button('Usage remaining').click())
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Open usage')
  expect(document.querySelector('[data-usage-details] [data-slot="usage-meter-row"]')).not.toBeNull()
  act(() => button('Open usage').click())
  expect(sidebarProps.onOpenUsage).toHaveBeenCalledWith(expect.any(String))
})
it('seat menu offers scoped Sign in when the session agent has no account', async () => {
  const store = previewStore(), runtime = store.getSnapshot().runtimes[0]!
  store.patch({ activeRuntime: runtime.id, activeSessionKey: null, accountsByRuntime: { [runtime.id]: { accounts: [], signInMethods: [], preferred: null } } as never, usage: [], health: { state: 'ready' }, runtimes: [{ ...runtime, capabilities: { ...runtime.capabilities, account: true } }] })
  await act(async () => root.render(<StoreProvider store={store}><Sidebar {...sidebarProps} /></StoreProvider>))
  act(() => host.querySelector<HTMLButtonElement>('[data-left-seat] [data-slot="popover-trigger"]')!.click())
  expect(document.querySelector('[role="menu"]')?.textContent).toContain(`Sign in to ${runtime.presentation.name}`)
  act(() => button(`Sign in to ${runtime.presentation.name}`).click())
  expect(sidebarProps.onSignIn).toHaveBeenCalledWith(runtime.id)
})
it('Activity starts with tasks across the app and retains completed output and stop/clear', async () => {
  const foreign = sessionKey(runtimeId('fixture'), sessionId('foreign'))
  const store = previewStore({ tasks: new Map([[PREVIEW_SESSION_KEY, [task('Local running'), task('Local finished', 'completed')]], [foreign, [task('Foreign running')]]]) })
  const stop = vi.fn(), clear = vi.fn(); Object.assign(store, { stopTask: stop, clearTasks: clear })
  await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'owner', view: { kind: 'conversation', session: PREVIEW_SESSION_KEY }, sessionKey: PREVIEW_SESSION_KEY }}><WorkActivityView /></PaneProvider></StoreProvider>))
  expect(host.querySelector('[data-slot="tool-section"]')?.getAttribute('aria-label')).toBe('Background work')
  expect(host.textContent).toContain('Foreign running')
  expect(host.textContent).toContain('Local finished')
  expect(host.textContent).toContain('Recorded output')
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Stop Local running"]')!.click())
  expect(stop).toHaveBeenCalledWith('Local running', PREVIEW_SESSION_KEY)
  act(() => button('Clear').click()); expect(clear).toHaveBeenCalledWith(PREVIEW_SESSION_KEY)
})
it('Activity button dot follows any running task and leaves when all are finished', () => {
  const store = previewStore({ tasks: new Map([[PREVIEW_SESSION_KEY, [task('Running')]]]) })
  act(() => root.render(<StoreProvider store={store}><WorkTools /></StoreProvider>))
  expect(host.querySelector('[data-work-tool="activity"] [data-slot="tool-dot"]')).not.toBeNull()
  act(() => store.patch({ tasks: new Map([[PREVIEW_SESSION_KEY, [task('Running', 'completed')]]]) }))
  expect(host.querySelector('[data-slot="tool-dot"]')).toBeNull()
})
const NoticeHost = () => {
  const refs = useShellHosts('work')
  return <><div ref={refs.topRef} /><div data-testid="main-notice" ref={refs.mainRef} /></>
}
it('connection Banner is at main top only during slow connecting, reconnecting and disconnection', () => {
  vi.useFakeTimers()
  const store = previewStore({ status: 'connecting' })
  act(() => root.render(<StoreProvider store={store}><TopBarProvider><ShellHostsProvider><NoticeHost /><ShellOutlets activeOwner={null} /></ShellHostsProvider></TopBarProvider></StoreProvider>))
  const notice = () => host.querySelector('[data-testid="main-notice"] [data-slot="alert"]')
  expect(notice()).toBeNull()
  act(() => vi.advanceTimersByTime(5000)); expect(notice()).not.toBeNull()
  act(() => store.patch({ status: 'open' })); expect(notice()).toBeNull()
  act(() => store.patch({ status: 'reconnecting' })); expect(notice()?.textContent).toContain('Reconnecting')
  act(() => store.patch({ status: 'closed' })); expect(notice()?.textContent).toContain('Disconnected')
  act(() => store.patch({ status: 'open' })); expect(notice()).toBeNull()
})
it('a page with an applicable action omits the Terminal toggle and its shortcut', async () => {
  const store = previewStore()
  const more = (close: () => void) => <MenuItem icon={<span />} label="Open this setting" onSelect={close} />
  const Register = () => { useTopBar('page', { place: 'Settings', more }); return <TopBarOutlet owner="page" fallback={{ place: 'Settings', more }} /> }
  await act(async () => root.render(<StoreProvider store={store}><TopBarProvider><Register /></TopBarProvider></StoreProvider>))
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="More"]')
  expect(trigger).not.toBeNull()
  act(() => trigger!.click())
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Open this setting')
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Terminal')
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('⌃`')
})
it('Control-backtick toggles Terminal while Command-backtick and handled events remain available', () => {
  const chord = { key: '`', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }
  const shortcut = shortcutFor(chord)
  expect(shortcut?.action).toBe('toggle-terminal')
  expect(chordOf(shortcut!)).toBe('⌃`')
  expect(shortcutFor({ ...chord, ctrlKey: false, metaKey: true })).toBeNull()
  expect(shortcutFor({ ...chord, defaultPrevented: true })).toBeNull()
})

it.each(['empty', 'finished'] as const)('Activity puts foreign running work before the subject’s %s task list', async local => {
  const foreign = sessionKey(runtimeId('fixture'), sessionId('foreign'))
  const store = previewStore({ tasks: new Map([[PREVIEW_SESSION_KEY, local === 'finished' ? [task('Local finished', 'completed')] : []], [foreign, [task('Foreign running')]]]) })
  await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'owner', view: { kind: 'conversation', session: PREVIEW_SESSION_KEY }, sessionKey: PREVIEW_SESSION_KEY }}><WorkActivityView /></PaneProvider></StoreProvider>))
  expect(host.querySelector('[data-slot="tool-section"]')?.textContent).toContain('Foreign running')
})

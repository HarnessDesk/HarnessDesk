import { act, isValidElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import type { AppSnapshot } from '../state/store'
import { previewStore } from '../preview/harness'
import { SettingsNavigation } from './SettingsNavigation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const row = (name: string) => container.querySelector<HTMLButtonElement>(`[data-left-row] button[aria-label="${name}"]`)
const filter = (value: string) => {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('Back and search use the preference groups; selection stays controlled', () => {
  const select = vi.fn(), back = vi.fn()
  act(() => root.render(<StoreProvider store={previewStore()}>
    <SettingsNavigation section="general" onSection={select} onBack={back} />
  </StoreProvider>))
  expect(row('General')?.getAttribute('aria-current')).toBe('page')
  expect(row('Library')).toBeNull()
  expect(row('Plugins')).toBeNull()
  filter('mute')
  expect(row('Notifications')).not.toBeNull()
  expect(row('General')).toBeNull()
  act(() => row('Notifications')!.click())
  expect(select).toHaveBeenCalledWith('notifications')
  expect(row('Notifications')?.getAttribute('aria-current')).toBeNull()
  act(() => row('Back')!.click())
  expect(back).toHaveBeenCalledOnce()
})


import { filterSettingsGroups, settingsGroups } from './settings-navigation'

test('the Settings middle keeps preference order across agent capabilities', () => {
  const snapshot = previewStore().getSnapshot()
  const source = snapshot.runtimes[0]!
  const runtime = { ...source, presentation: { ...source.presentation, skillsLabel: 'Commands' },
    capabilities: { ...source.capabilities, extensionStore: false, mcp: false } }
  const groups = settingsGroups(snapshot, runtime)
  expect(groups.map(group => group.label)).toEqual(['Preferences', 'Conversations', 'Runtimes', 'Access'])
  expect(groups.flatMap(group => group.entries.map(entry => entry.id))).toEqual([
    'profile', 'general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'history', 'storage', 'archive',
    'runtimes', 'models', 'hooks', 'extensions', 'permissions', 'browser',
  ])
  const skills = groups.flatMap(group => group.entries).find(entry => entry.id === 'hooks')!
  expect(skills.label).toBe('Hooks')
  expect(skills.title).toContain(source.presentation.name)
  expect(settingsGroups(snapshot, { ...runtime, capabilities: { ...runtime.capabilities, mcp: true } })
    .flatMap(group => group.entries.map(entry => entry.id))).toContain('extensions')
  expect(filterSettingsGroups(groups, '  MUTE  ').flatMap(group => group.entries.map(entry => entry.id))).toEqual(['notifications'])
  expect(filterSettingsGroups(groups, 'zzzz')).toEqual([])
})

test('only the Runtimes group names its own destination and each destination has its own icon', () => {
  const snapshot = previewStore().getSnapshot()
  const groups = settingsGroups(snapshot, snapshot.runtimes[0]!)
  const entries = groups.flatMap(group => group.entries)

  for (const group of groups) {
    expect(group.entries.filter(entry => entry.label === group.label).map(entry => entry.id))
      .toEqual(group.label === 'Runtimes' ? ['runtimes'] : [])
  }
  const iconTypes = entries.map(entry => {
    expect(isValidElement(entry.icon)).toBe(true)
    return (entry.icon as ReactElement).type
  })
  expect(new Set(iconTypes).size).toBe(entries.length)
})

test('the reused window rail keyboard handler leaves search editing alone', () => {
  const select = vi.fn(), back = vi.fn()
  act(() => root.render(<StoreProvider store={previewStore()}>
    <SettingsNavigation section="general" onSection={select} onBack={back} />
  </StoreProvider>))
  const key = (target: HTMLElement, value: string) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
  row('Back')!.focus()
  key(row('Back')!, 'ArrowDown')
  expect(document.activeElement).toBe(row('Account'))
  key(row('Account')!, 'ArrowDown')
  expect(document.activeElement).toBe(row('General'))
  key(row('General')!, 'ArrowDown')
  expect(document.activeElement).toBe(row('Appearance'))
  key(row('Appearance')!, 'Enter')
  expect(select).toHaveBeenCalledWith('appearance')
  expect(row('General')!.getAttribute('aria-current')).toBe('page')
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!
  search.focus()
  key(search, 'ArrowDown')
  expect(document.activeElement).toBe(search)
  expect(select).toHaveBeenCalledOnce()
})


test('navigation keeps its groups and labels before and after the runtime read', () => {
  const store = previewStore()
  const loaded = store.getSnapshot()
  let snapshot: AppSnapshot = { ...loaded, runtimes: [], activeRuntime: null }
  const listeners = new Set<() => void>()
  Object.assign(store, { getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => listeners.delete(listener)
  } })
  act(() => root.render(<StoreProvider store={store}>
    <SettingsNavigation section="general" onSection={() => {}} onBack={() => {}} />
  </StoreProvider>))
  const labels = () => [...container.querySelectorAll('[data-left-row] button')].map(one => one.textContent)
  const before = labels()
  expect(row('Skills')).toBeNull()
  expect(row('Hooks')).not.toBeNull()
  expect(row('Extensions')).not.toBeNull()
  act(() => {
    snapshot = { ...loaded, runtimes: loaded.runtimes.map(runtime => ({ ...runtime,
      presentation: { ...runtime.presentation, skillsLabel: 'Skills & commands' },
      capabilities: { ...runtime.capabilities, mcp: false, extensionStore: false },
    })) }
    listeners.forEach(listener => listener())
  })
  expect(labels()).toEqual(before)
})


test('legacy command details keep the parent Runtimes navigation selected', () => {
  act(() => root.render(<StoreProvider store={previewStore()}><SettingsNavigation section="skills" onSection={() => {}} onBack={() => {}} /></StoreProvider>))
  expect(row('Runtimes')?.getAttribute('aria-current')).toBe('page')
  expect(row('Skills')).toBeNull()
})

test('Phone is available for account linking even when the LAN listener is off', () => {
  const snapshot = previewStore().getSnapshot(), runtime = snapshot.runtimes[0]!
  const entries = (phoneLink: boolean, accountLinkAvailable: boolean) => settingsGroups({ ...snapshot, phoneLink, accountLinkAvailable }, runtime).flatMap(g => g.entries.map(e => e.id))
  expect(entries(false, false)).not.toContain('phone')
  expect(entries(false, true)).toContain('phone')
  expect(entries(true, false)).toContain('phone')
})

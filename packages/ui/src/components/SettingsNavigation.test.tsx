import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { StoreProvider } from '../state/context'
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

test('the Settings middle keeps preference order and gates agent-owned pages on capabilities', () => {
  const snapshot = previewStore().getSnapshot()
  const source = snapshot.runtimes[0]!
  const runtime = { ...source, presentation: { ...source.presentation, skillsLabel: 'Commands' },
    capabilities: { ...source.capabilities, extensionStore: false, mcp: false } }
  const groups = settingsGroups(snapshot, runtime)
  expect(groups.map(group => group.label)).toEqual(['General', 'Conversations', 'Agents', 'Access'])
  expect(groups.flatMap(group => group.entries.map(entry => entry.id))).toEqual([
    'general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'history', 'storage', 'archive',
    'runtimes', 'models', 'skills', 'permissions', 'browser',
  ])
  const skills = groups.flatMap(group => group.entries).find(entry => entry.id === 'skills')!
  expect(skills.label).toBe('Commands')
  expect(skills.title).toContain(source.presentation.name)
  expect(settingsGroups(snapshot, { ...runtime, capabilities: { ...runtime.capabilities, mcp: true } })
    .flatMap(group => group.entries.map(entry => entry.id))).toContain('extensions')
  expect(filterSettingsGroups(groups, '  MUTE  ').flatMap(group => group.entries.map(entry => entry.id))).toEqual(['notifications'])
  expect(filterSettingsGroups(groups, 'zzzz')).toEqual([])
})

test('the reused window rail keyboard handler leaves search editing alone', () => {
  const select = vi.fn(), back = vi.fn()
  act(() => root.render(<StoreProvider store={previewStore()}>
    <SettingsNavigation section="general" onSection={select} onBack={back} />
  </StoreProvider>))
  const key = (target: HTMLElement, value: string) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
  row('Back')!.focus()
  key(row('Back')!, 'ArrowDown')
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

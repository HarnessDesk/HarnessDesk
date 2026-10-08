import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sessionId, sessionKey, type ConfigOption, type OptionCategory, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import { ComposerTools } from '../design'
import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import type { RoomMember } from './RoomComposer'
import { ModelControl, PermissionControl } from './ComposerControls'
import { RoomComposerOptions } from './RoomComposerOptions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const keys = [sessionKey('agent-a', 'one'), sessionKey('agent-b', 'two')]
const members = keys.map((key, index): RoomMember => ({ key, peer: { nickname: index ? 'Beta' : 'Alpha', here: true } as RoomMember['peer'], brand: null, busy: false, canUseBoard: true, title: null }))
const select = (id: string, category: OptionCategory, value = 'one'): ConfigOption => ({
  id, category, label: category === 'model' ? 'Model' : category,
  type: 'select', currentValue: value,
  choices: [{ value: 'one', label: 'First' }, { value: 'two', label: 'Second' }],
})
const options = (value = 'one') => [select('model', 'model', value), select('permission', '_permissions', value), select('mode', 'mode', value), select('custom', '_custom', value)]
const rig = (second = options(), patch: Partial<AppSnapshot> = {}) => {
  const runtimes = ['agent-a', 'agent-b'].map((id) => ({ id, name: 'Test agent', presentation: { name: 'Test agent' }, capabilities: {} } as RuntimeInfo))
  const snapshot: AppSnapshot = { ...emptySnapshot(), status: 'open', runtimes, activeRuntime: runtimes[0]!.id, activeSessionKey: keys[0]!, sessions: new Map(keys.map((key, index) => [key, {
    id: sessionId(index ? 'two' : 'one'), runtime: runtimes[index]!.id, cwd: '/repo', status: { type: 'idle' }, turns: [], createdAt: 1, updatedAt: 1, itemsLoaded: true, options: index ? second : options(),
  } as Session])), ...patch }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, setOption: vi.fn(async () => {}), applyPreset: vi.fn(async () => {}), askSettings: vi.fn() } as unknown as AppStore
  return { store, snapshot }
}
const click = (target: Element) => act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const mount = (store: AppStore, recipients = members) => act(() => root.render(<StoreProvider store={store}><ComposerTools><RoomComposerOptions members={recipients} /></ComposerTools></StoreProvider>))

it('keeps four fixed setting slots and shows equal current values', () => {
  mount(rig().store)
  const slots = [...container.querySelectorAll<HTMLElement>('[data-composer-track]')]
  expect(slots.map((slot) => slot.dataset.composerTrack)).toEqual(['permissions', 'mode', 'more', 'model'])
  expect(slots.map((slot) => slot.textContent?.trim())).toEqual(['First', 'First', 'More', 'First'])
})

it('shows Mixed for each slot whose addressed members have different values', () => {
  mount(rig(options('two')).store)
  expect([...container.querySelectorAll('[data-composer-track]')].map((slot) => slot.textContent?.trim())).toEqual(['Mixed', 'Mixed', 'Mixed', 'Mixed'])
})

it('keeps different declared values Mixed even when their labels match', () => {
  const sameLabels = options('two').map((option) => option.type === 'select' ? { ...option, choices: option.choices.map((choice) => ({ ...choice, label: 'First' })) } : option)
  mount(rig(sameLabels).store)
  expect([...container.querySelectorAll('[data-composer-track]')].map((slot) => slot.textContent?.trim())).toEqual(['Mixed', 'Mixed', 'Mixed', 'Mixed'])
})

it('opens the named members and edits only the chosen member through its existing control', () => {
  const { store } = rig(options('two'))
  mount(store)
  click(container.querySelector('[data-composer-track="model"] button')!)
  const targets = document.querySelectorAll<HTMLElement>('[data-option-target]')
  expect([...targets].map((target) => target.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Alpha'), expect.stringContaining('Beta')]))
  click(targets[1]!.querySelector('button')!)
  const first = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.trim() === 'First')!
  expect(first).toBeTruthy()
  click(first)
  expect(store.setOption).toHaveBeenCalledExactlyOnceWith('model', 'one', keys[1])
})

it('shows unavailable members with their reason without rendering mutable controls', () => {
  mount(rig().store, [members[0]!, { ...members[1]!, unavailable: 'Agent is unavailable' }])
  click(container.querySelector('[data-composer-track="model"] button')!)
  const target = [...document.querySelectorAll<HTMLElement>('[data-option-target]')].find((node) => node.dataset.optionTarget === keys[1])!
  expect(target.textContent).toContain('Beta')
  expect(target.textContent).toContain('Agent is unavailable')
  expect(target.querySelector('button')).toBeNull()
})

it('existing controls pass a nonactive pane session to the option mutation', () => {
  const { store } = rig()
  act(() => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'target', view: { kind: 'conversation', session: keys[1]! }, sessionKey: keys[1]! }}><ModelControl /></PaneProvider></StoreProvider>))
  click(container.querySelector('button')!)
  click([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.trim() === 'Second')!)
  expect(store.setOption).toHaveBeenCalledExactlyOnceWith('model', 'two', keys[1])
})

it('offers the target runtime presets and applies one only to the target session', () => {
  const preset = { id: 'beta-preset', runtime: 'agent-b', name: 'Beta setup', description: '', values: { permission: 'two' } }
  const { store } = rig(options(), { customPresets: [{ ...preset, id: 'alpha-preset', runtime: 'agent-a', name: 'Alpha setup' }, preset] })
  act(() => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'target', view: { kind: 'conversation', session: keys[1]! }, sessionKey: keys[1]! }}><PermissionControl /></PaneProvider></StoreProvider>))
  click(container.querySelector('button')!)
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.trim() === 'Beta setup')!
  expect(row).toBeTruthy()
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Alpha setup')
  click(row)
  expect(store.applyPreset).toHaveBeenCalledExactlyOnceWith(preset, keys[1])
})

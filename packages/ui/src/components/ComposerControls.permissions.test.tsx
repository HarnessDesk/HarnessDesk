import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type ConfigOption, type RuntimeInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ModeControl, PermissionControl } from './ComposerControls'

vi.mock('../design', async (original) => ({ ...(await original<typeof import('../design')>()), Dialog: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const permissionMode = {
  id: 'mode', label: 'Unrelated label', description: 'Unrelated description', category: '_permissions', type: 'select',
  currentValue: 'manual', collaboration: { planValue: 'planning', actValue: 'manual' },
  choices: [{ value: 'manual', label: 'Manual' }, { value: 'edit', label: 'Accept edits' }, { value: 'planning', label: 'Plan' }],
} as ConfigOption
const draw = (option: ConfigOption) => {
  const state = { ...emptySnapshot(), activeRuntime: runtimeId('test'),
    runtimes: [{ id: runtimeId('test'), presentation: { name: 'Agent' }, capabilities: {} } as RuntimeInfo], draftOptions: [option] }
  const setOption = vi.fn(async (_id: string, value: string | boolean) => { state.draftOptions = [{ ...option, currentValue: value } as ConfigOption]; render() })
  const store = { getSnapshot: () => state, subscribe: () => () => {}, setOption } as unknown as AppStore
  const render = () => act(() => root.render(<StoreProvider store={store}><PermissionControl /><ModeControl /></StoreProvider>))
  render()
  return setOption
}
const choose = async (track: string, label: string) => {
  act(() => container.querySelector<HTMLButtonElement>(`[data-composer-track="${track}"] button`)!.click())
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(row => row.textContent?.trim() === label)!
  expect(row).toBeDefined()
  await act(async () => row.click())
}
it('splits adapter-declared permission modes into one Permissions slot and a collaboration control', () => {
  draw(permissionMode)
  expect(container.querySelector('[title="This agent has no permission setting"]')).toBeNull()
  const permissions = container.querySelector('[data-composer-track="permissions"] button')!
  expect(permissions.getAttribute('aria-label')).toContain('Permissions')
  expect(container.querySelector('[data-composer-track="mode"]')?.textContent).toContain('Act')
  act(() => (permissions as HTMLButtonElement).click())
  expect([...document.querySelectorAll('[role="menuitemradio"]')].map(row => row.textContent?.trim())).toEqual(['Manual', 'Accept edits'])
})
it('keeps a permission pick visible in the draft and sends the existing option id and values', async () => {
  const setOption = draw(permissionMode)
  await choose('permissions', 'Accept edits')
  expect(setOption).toHaveBeenLastCalledWith('mode', 'edit')
  expect(container.querySelector('[data-composer-track="permissions"] button')?.textContent).toContain('Accept edits')
  await choose('mode', 'Plan')
  expect(setOption).toHaveBeenLastCalledWith('mode', 'planning')
  expect(container.querySelector('[data-composer-track="mode"] button')?.textContent).toContain('Plan')
})
it('shows no collaboration control when the agent declares only permissions', () => {
  const { collaboration: _split, ...option } = permissionMode as ConfigOption & { collaboration: unknown }
  draw(option)
  expect(container.querySelector('[data-composer-track="mode"]')).toBeNull()
})
it('keeps an unavailable permission value visible instead of calling it planning', () => {
  draw({ ...permissionMode, currentValue: 'retired' } as ConfigOption)
  expect(container.querySelector('[data-composer-track="permissions"] button')?.textContent).toContain('retired — Unavailable')
})

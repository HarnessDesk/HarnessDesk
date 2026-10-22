import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type HookInfo, type RuntimeInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SettingsTestScope } from '../test-support/settings-page'
import { Settings } from './Settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const runtime = (id: string, hooks = true) => ({ id: runtimeId(id), capabilities: { hooks }, presentation: { name: 'Test Agent' } }) as RuntimeInfo
const hook: HookInfo = { id: 'before', event: 'preToolUse', source: 'project', trust: 'trusted', enabled: true, managed: false }
const mount = async (infos: RuntimeInfo[], loadHooks: AppStore['loadHooks']) => {
  let snapshot = { ...emptySnapshot(), runtimes: infos, activeRuntime: infos[0]!.id } as AppSnapshot
  const listeners = new Set<() => void>()
  const store = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, loadHooks } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope><Settings route={{ kind: 'section', section: 'hooks', focus: null }} onRoute={() => {}} onSignIn={() => {}} /></SettingsTestScope></StoreProvider>))
  return async (active: RuntimeInfo) => { await act(async () => { snapshot = { ...snapshot, activeRuntime: active.id }; listeners.forEach(listener => listener()) }) }
}

it('explains when the selected runtime does not report hooks', async () => {
  const load = vi.fn(async () => [])
  await mount([runtime('one', false)], load)
  expect(container.textContent).toContain('Hooks are not available')
  expect(load).not.toHaveBeenCalled()
})

it('shows loading and empty states on the standalone Hooks page', async () => {
  let answer!: (items: HookInfo[]) => void
  await mount([runtime('one')], () => new Promise(resolve => { answer = resolve }))
  expect(container.textContent).toContain('Reading hooks…')
  await act(async () => answer([]))
  expect(container.textContent).toContain('No hooks configured')
})

it('reads a newly selected runtime and ignores a late previous response', async () => {
  const one = runtime('one'), two = runtime('two')
  let answer!: (items: HookInfo[]) => void
  const load = vi.fn().mockImplementationOnce(() => new Promise(resolve => { answer = resolve })).mockResolvedValueOnce([])
  const select = await mount([one, two], load)
  await select(two)
  expect(load).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('No hooks configured')
  await act(async () => answer([hook]))
  expect(container.textContent).not.toContain('preToolUse')
})

it('renders configured hooks with their trust', async () => {
  await mount([runtime('one')], async () => [hook])
  expect(container.textContent).toContain('preToolUse')
  expect(container.textContent).toContain('Trusted')
})

it('offers retry after a hook read rejects', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValueOnce([hook])
  await mount([runtime('one')], load)
  expect(container.textContent).toContain('Hooks could not be read')
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Try again')!.click())
  expect(container.textContent).toContain('preToolUse')
})

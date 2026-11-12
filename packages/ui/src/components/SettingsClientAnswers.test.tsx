import { SettingsTestPage as Settings } from '../test-support/settings-page'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { AppStore, emptySnapshot } from '../state/store'
import type { McpStartsView } from '@harnessdesk/protocol'
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LABEL = 'Let command-line clients answer for me'
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const mount = (load?: () => Promise<boolean>, save?: (value: boolean) => Promise<boolean>) => {
  const snapshot = { ...emptySnapshot(), status: 'open' as const }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadPolicyRules: vi.fn(async () => []),
    loadUnheldCeilings: vi.fn(async () => 'seat'),
    loadUnattendedCeilings: vi.fn(async () => 'refuse'),
    loadQuestionWait: vi.fn(async () => '5m'),
    loadCarryOnPolicy: vi.fn(async () => ({ onLimit: 'ask', otherAgents: true })),
    readCarryOnRules: async () => true,
    ...(load ? { loadClientsMayAnswer: load } : {}),
    ...(save ? { setClientsMayAnswer: save } : {}),
  } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <Settings section="permissions" onSection={() => {}} onClose={() => {}} onSignIn={() => {}} />
    </StoreProvider>,
  ))
}

const control = (): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[role="switch"][aria-label="${LABEL}"]`)
  expect(found, 'Permissions offers the client answer preference').not.toBeNull()
  return found!
}

it('reads client answering from this desk, defaults off and accepts only literal true', async () => {
  const store = new AppStore('ws://localhost:0/')
  const values: unknown[] = [undefined, false, true, 'true', '1', 1, null, {}, []]
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async () => ({ clientsMayAnswer: values.shift() })) as never)
  const answers: boolean[] = []
  for (const _value of values.slice()) answers.push(await store.loadClientsMayAnswer())
  expect(answers).toEqual([false, false, true, false, false, false, false, false, false])
  expect(request.mock.calls.every(([method, params]) => method === 'app/state/get' && JSON.stringify(params) === '{}')).toBe(true)
})

it('an unreadable client answer preference stays off', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockRejectedValueOnce(new Error('state is unreadable'))
  await expect(store.loadClientsMayAnswer()).resolves.toBe(false)
})

it('writes only the client answer preference and reads it back, including revocation', async () => {
  const store = new AppStore('ws://localhost:0/')
  const stored: Record<string, unknown> = { theme: 'dark' }
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: unknown) => {
    if (method === 'app/state/set') Object.assign(stored, (params as { patch: Record<string, unknown> }).patch)
    return method === 'app/state/get' ? stored : null
  }) as never)
  await expect(store.setClientsMayAnswer(true)).resolves.toBe(true)
  expect(await store.loadClientsMayAnswer()).toBe(true)
  await expect(store.setClientsMayAnswer(false)).resolves.toBe(true)
  expect(await store.loadClientsMayAnswer()).toBe(false)
  expect(stored).toEqual({ theme: 'dark', clientsMayAnswer: false })
  expect(request).toHaveBeenCalledWith('app/state/set', { patch: { clientsMayAnswer: true } })
  expect(request).toHaveBeenCalledWith('app/state/set', { patch: { clientsMayAnswer: false } })
})

it('reports a refused client answer preference write through the common preference failure notice', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockRejectedValueOnce(new Error('writes are unavailable'))
  await expect(store.setClientsMayAnswer(true)).resolves.toBe(false)
  expect(store.getSnapshot().notices.map((notice) => notice.message).join(' ')).toContain('could not be saved')
})

it('renders one Permissions row without a second line and covers other local clients in its hover title', async () => {
  mount(vi.fn(async () => false), vi.fn(async () => true))
  await act(async () => {})
  expect(control().getAttribute('aria-checked')).toBe('false')
  const row = control().closest('[data-slot="row"]')!
  expect(row.querySelector('[data-slot="row-title"]')?.textContent).toBe(LABEL)
  expect(row.textContent).toBe(LABEL)
  expect(control().closest('[title]')?.getAttribute('title')).toContain('other local clients')
})

it('disables the switch until the stored choice has loaded', async () => {
  let finish!: (value: boolean) => void
  mount(() => new Promise((resolve) => { finish = resolve }), vi.fn(async () => true))
  await act(async () => {})
  expect(control().hasAttribute('data-disabled')).toBe(true)
  await act(async () => { finish(true) })
  expect(control().hasAttribute('data-disabled')).toBe(false)
  expect(control().getAttribute('aria-checked')).toBe('true')
})

it('keeps a saved choice and rolls back when a write is refused', async () => {
  const save = vi.fn(async (value: boolean) => value)
  mount(vi.fn(async () => false), save)
  await act(async () => {})
  await act(async () => { control().click() })
  expect(save).toHaveBeenLastCalledWith(true)
  expect(control().getAttribute('aria-checked')).toBe('true')
  await act(async () => { control().click() })
  expect(save).toHaveBeenLastCalledWith(false)
  expect(control().getAttribute('aria-checked')).toBe('true')
})

it('prevents a second choice while the first write is pending', async () => {
  let finish!: (value: boolean) => void
  const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
  mount(vi.fn(async () => false), save)
  await act(async () => {})
  act(() => control().click())
  expect(control().hasAttribute('data-disabled')).toBe(true)
  act(() => control().click())
  expect(save).toHaveBeenCalledTimes(1)
  await act(async () => { finish(true) })
  expect(control().hasAttribute('data-disabled')).toBe(false)
  expect(control().getAttribute('aria-checked')).toBe('true')
})

it('an unavailable preference reader or writer leaves the switch off and disabled', async () => {
  mount()
  await act(async () => {})
  expect(control().getAttribute('aria-checked')).toBe('false')
  expect(control().hasAttribute('data-disabled')).toBe(true)
})

/* ---- MCP clients: whether they may start work, and how many times a day ---- */

const MCP_LABEL = 'Let MCP clients start work'
const mcpView = (over: Partial<McpStartsView> = {}): McpStartsView => ({
  version: 1, revision: 3, mayStart: false, dailyStarts: 5, day: '2026-11-11', started: 0, remaining: 5, source: 'stored', ...over,
})
const mountMcp = (load: () => Promise<McpStartsView | null>, save: (revision: number, patch: { mayStart?: boolean; dailyStarts?: number }) => Promise<McpStartsView | null>) => {
  const snapshot = { ...emptySnapshot(), status: 'open' as const }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadPolicyRules: vi.fn(async () => []),
    loadUnheldCeilings: vi.fn(async () => 'seat'),
    loadUnattendedCeilings: vi.fn(async () => 'refuse'),
    loadQuestionWait: vi.fn(async () => '5m'),
    loadClientsMayAnswer: vi.fn(async () => false),
    setClientsMayAnswer: vi.fn(async () => true),
    loadMcpStarts: load,
    setMcpStarts: save,
  } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <Settings section="permissions" onSection={() => {}} onClose={() => {}} onSignIn={() => {}} />
    </StoreProvider>,
  ))
}
const mcpSwitch = (): HTMLElement => container.querySelector<HTMLElement>(`[role="switch"][aria-label="${MCP_LABEL}"]`)!
const daily = (): HTMLSelectElement => container.querySelector<HTMLSelectElement>('select[aria-label="Starts a day"]')!
const rowOf = (element: Element): Element => element.closest('[data-slot="row"]')!

it('offers both MCP rows under their own label, off with no second line and the number disabled', async () => {
  mountMcp(vi.fn(async () => mcpView()), vi.fn(async () => mcpView()))
  await act(async () => {})
  expect(mcpSwitch()).not.toBeNull()
  expect(daily()).not.toBeNull()
  expect(container.textContent).toContain('MCP clients')
  expect(mcpSwitch().getAttribute('aria-checked')).toBe('false')
  expect(rowOf(mcpSwitch()).textContent).toBe(MCP_LABEL)
  expect(daily().disabled).toBe(true)
  expect([...daily().options].map(option => option.value)).toEqual(['1', '3', '5', '10', '20', '50'])
  expect(rowOf(daily()).getAttribute('title')).toBe('Counted from midnight, your time. A start that fails is not counted.')
})

it('turning starts on saves from the revision it read, then shows how many today has used', async () => {
  const save = vi.fn(async (_revision: number, patch: { mayStart?: boolean }) => mcpView({ revision: 4, mayStart: patch.mayStart === true, started: 2, remaining: 3 }))
  mountMcp(vi.fn(async () => mcpView()), save)
  await act(async () => {})
  await act(async () => { mcpSwitch().click() })
  expect(save).toHaveBeenCalledWith(3, { mayStart: true })
  expect(mcpSwitch().getAttribute('aria-checked')).toBe('true')
  expect(rowOf(mcpSwitch()).textContent).toContain('2 of 5 used today')
  expect(daily().disabled).toBe(false)
  await act(async () => {
    daily().value = '20'
    daily().dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(save).toHaveBeenLastCalledWith(4, { dailyStarts: 20 })
})

it('a refused save puts the previous choice back and reads the desk again', async () => {
  const load = vi.fn(async () => mcpView())
  mountMcp(load, vi.fn(async () => null))
  await act(async () => {})
  await act(async () => { mcpSwitch().click() })
  expect(mcpSwitch().getAttribute('aria-checked')).toBe('false')
  expect(rowOf(mcpSwitch()).textContent).toBe(MCP_LABEL)
  expect(load).toHaveBeenCalledTimes(2)
})

it('a desk that grants starts from its environment shows the switch on and locked', async () => {
  mountMcp(vi.fn(async () => mcpView({ mayStart: true, source: 'environment', started: 1, remaining: 4 })), vi.fn(async () => null))
  await act(async () => {})
  expect(mcpSwitch().getAttribute('aria-checked')).toBe('true')
  expect(mcpSwitch().hasAttribute('data-disabled')).toBe(true)
  expect(rowOf(mcpSwitch()).getAttribute('title')).toContain('HARNESSDESK_MCP_MAY_START')
  expect(rowOf(mcpSwitch()).textContent).toContain('1 of 5 used today')
})

it('the Local clients section names no agent', async () => {
  mountMcp(vi.fn(async () => mcpView({ mayStart: true })), vi.fn(async () => null))
  await act(async () => {})
  const section = rowOf(mcpSwitch()).closest('section') ?? container
  expect(section.textContent ?? '').not.toMatch(/Codex|Claude|Cursor|OpenCode|Gemini/i)
})

it('reads and writes MCP starts through their own methods, never window preferences', async () => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'app/mcpStarts/get' ? mcpView() : mcpView({ revision: 4, mayStart: true })) as never)
  expect(await store.loadMcpStarts()).toEqual(mcpView())
  expect((await store.setMcpStarts(3, { mayStart: true }))?.mayStart).toBe(true)
  expect(request.mock.calls).toEqual([['app/mcpStarts/get', {}], ['app/mcpStarts/set', { revision: 3, mayStart: true }]])
  request.mockRejectedValueOnce(new Error('stale'))
  expect(await store.setMcpStarts(3, { dailyStarts: 9 })).toBeNull()
  expect(store.getSnapshot().notices.map((notice) => notice.message).join(' ')).toContain('Letting MCP clients start work could not be saved')
})

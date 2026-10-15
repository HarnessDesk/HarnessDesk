import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { NO_CAPABILITIES, runtimeId, sessionId, sessionKey, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore, type UnheldCeilings } from '../state/store'
import { CeilingsSection } from './SettingsCeilings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const runtime = (id: string, name: string, held = false): RuntimeInfo => ({
  id: runtimeId(id),
  capabilities: NO_CAPABILITIES,
  presentation: { name },
  ...(held ? {
    ceilings: {
      read: { settings: [{ option: 'sandbox', value: 'read-only' }], how: 'Read-only sandbox' },
      edit: { settings: [{ option: 'sandbox', value: 'workspace' }], how: 'Workspace sandbox' },
    },
  } : {}),
}) as RuntimeInfo

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const mount = ({
  runtimes = [runtime('alpha', 'Alpha', true), runtime('beta', 'Beta')],
  load = vi.fn(async () => 'seat' as UnheldCeilings),
  save = vi.fn(async () => {}),
  loadUnattended = vi.fn(async () => 'refuse' as UnheldCeilings),
  saveUnattended = vi.fn(async () => {}),
  focus = null,
  evidence,
}: {
  runtimes?: readonly RuntimeInfo[]
  load?: AppStore['loadUnheldCeilings']
  save?: AppStore['saveUnheldCeilings']
  loadUnattended?: AppStore['loadUnattendedCeilings']
  saveUnattended?: AppStore['setUnattendedCeilings']
  focus?: string | null
  evidence?: Partial<AppSnapshot>
} = {}) => {
  let snapshot = { ...emptySnapshot(), status: 'open', runtimes: [...runtimes],
    accountsByRuntime: Object.fromEntries(runtimes.map(info => [info.id, { accounts: [{ kind: 'plan', label: 'dev@example.com' }], signInMethods: [] }])),
    ...evidence,
  } as AppSnapshot
  const listeners = new Set<() => void>()
  const store = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    loadUnheldCeilings: load,
    saveUnheldCeilings: save,
    loadUnattendedCeilings: loadUnattended,
    setUnattendedCeilings: saveUnattended,
  } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><CeilingsSection focus={focus} /></StoreProvider>))
  return {
    store,
    push: (next: readonly RuntimeInfo[]) => act(() => {
      snapshot = { ...snapshot, runtimes: [...next] }
      for (const listener of listeners) listener()
    }),
  }
}

const ceilingTitles = () => [...container.querySelectorAll('section[aria-label="Ceilings"] [data-slot="row-title"]')]
  .map(node => node.querySelector('[data-slot="row-title-name"]')?.textContent ?? node.textContent)
const otherAgents = () => container.querySelector<HTMLButtonElement>('section[aria-label="Ceilings"] button[aria-expanded]')
const usedSession = (id: string): Session => ({ id: sessionId(id), runtime: runtimeId(id), cwd: '/synthetic/project',
  status: { type: 'idle' }, createdAt: 1, updatedAt: 1, turns: [], itemsLoaded: true })

it('lists signed-in and used agents first and folds all other ceiling rows once', async () => {
  const runtimes = ['unused', 'signed', 'open', 'history', 'identity'].map(id => runtime(id, id))
  const open = usedSession('open'), history = usedSession('history'), identity = usedSession('identity')
  mount({ runtimes, evidence: {
    accountsByRuntime: { [runtimeId('signed')]: { accounts: [{ kind: 'plan', label: 'dev@example.com' }], signInMethods: [] } },
    sessions: new Map([[sessionKey(open.runtime, open.id), open]]), history: [history], historyIdentity: [identity],
  } })
  await act(async () => {})
  expect(ceilingTitles()).toEqual(['signed', 'open', 'history', 'identity', 'Other agents · 1'])
  const disclosure = otherAgents()!
  expect(disclosure).not.toBeNull()
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  act(() => disclosure.click())
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  expect(ceilingTitles()).toEqual(['signed', 'open', 'history', 'identity', 'Other agents · 1', 'unused'])
  act(() => disclosure.click())
  expect(ceilingTitles()).not.toContain('unused')
})

it('keeps a used account sibling with its agent, counting unused agents rather than account slots', async () => {
  const base = runtime('base', 'Base'), slot = { ...runtime('slot', 'Base account'), slot: { agent: base.id, home: '/synthetic/account', removable: true, canAdd: false } }
  const unused = runtime('unused', 'Unused'), unusedSlot = { ...runtime('unused-slot', 'Unused account'), slot: { agent: unused.id, home: '/synthetic/unused', removable: true, canAdd: false } }
  mount({ runtimes: [unused, unusedSlot, base, slot], evidence: {
    accountsByRuntime: { [slot.id]: { accounts: [{ kind: 'plan', label: 'dev@example.com' }], signInMethods: [] } },
  } })
  await act(async () => {})
  expect(ceilingTitles()).toEqual(['Base', 'Base account', 'Other agents · 1'])
  act(() => otherAgents()!.click())
  expect(ceilingTitles()).toEqual(['Base', 'Base account', 'Other agents · 1', 'Unused', 'Unused account'])
})

it('offers one disclosure when no agents are in use and none when all are in use', async () => {
  mount({ evidence: { accountsByRuntime: {} } })
  await act(async () => {})
  expect(ceilingTitles()).toEqual(['Other agents · 2'])
  act(() => otherAgents()!.click())
  expect(ceilingTitles()).toEqual(['Other agents · 2', 'Alpha', 'Beta'])
  mount()
  await act(async () => {})
  expect(ceilingTitles()).toEqual(['Alpha', 'Beta'])
  expect(otherAgents()).toBeNull()
})

/** The watched group's own two radios — "In a conversation you are watching". */
const choices = (): HTMLButtonElement[] =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[aria-label="If a runtime cannot hold a ceiling"] [role="radio"]')]
/** The unattended group's own two radios — "Goals a trigger opened". */
const unattendedChoices = (): HTMLButtonElement[] =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[aria-label="If a runtime cannot hold a ceiling in a Goal a trigger opened"] [role="radio"]')]
const runtimeRows = (): HTMLElement[] =>
  [...document.body.querySelectorAll<HTMLElement>('[data-slot="row"]')]
    .filter((row) => ['Alpha', 'Beta'].some((name) => row.querySelector('[data-slot="row-title"]')?.textContent?.startsWith(name)))

it('shows one effective ceiling and its enforcement state per runtime', async () => {
  mount()
  await act(async () => {})
  const rows = runtimeRows()
  expect(rows).toHaveLength(2)
  const [alpha, beta] = rows
  expect([...alpha!.querySelectorAll<HTMLElement>('[role="radio"]')].map((choice) => choice.textContent)).toEqual([
    'Read only', 'Edit', 'Publish', 'Merge',
  ])
  expect([...alpha!.querySelectorAll<HTMLElement>('[role="radio"]')].map((choice) => choice.getAttribute('aria-checked'))).toEqual([
    'false', 'true', 'false', 'false',
  ])
  expect([...beta!.querySelectorAll<HTMLElement>('[role="radio"]')].map((choice) => choice.getAttribute('aria-checked'))).toEqual([
    'true', 'false', 'false', 'false',
  ])
  expect([...rows[0]!.querySelectorAll<HTMLButtonElement>('[role="radio"]'), ...rows[1]!.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .every((choice) => choice.disabled)).toBe(true)
  expect(alpha!.querySelector('[data-slot="row-title-chip"]')?.textContent).toBe('Enforced')
  expect(beta!.querySelector('[data-slot="row-title-chip"]')?.textContent).toBe('Asked')
})

it('capabilities update after a runtime starts', async () => {
  const alpha = runtime('alpha', 'Alpha')
  const beta = runtime('beta', 'Beta')
  const { push } = mount({ runtimes: [alpha, beta] })
  await act(async () => {})
  expect(runtimeRows()[0]?.querySelector('[data-slot="row-title-chip"]')?.textContent).toBe('Asked')
  push([runtime('alpha', 'Alpha', true), beta])
  expect(runtimeRows()[0]?.querySelector('[data-slot="row-title-chip"]')?.textContent).toBe('Enforced')
  expect(runtimeRows()[1]?.querySelector('[data-slot="row-title-chip"]')?.textContent).toBe('Asked')
})

it('seats and says so by default, and writes the other choice when it is made', async () => {
  const save = vi.fn(async () => {})
  mount({ save })
  await act(async () => {})
  expect(choices().map((choice) => choice.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  await act(async () => choices()[1]!.click())
  expect(save).toHaveBeenCalledWith('refuse')
})

it('a pending load or save cannot be overtaken by a click', async () => {
  const loading = deferred<UnheldCeilings>()
  const saving = deferred<void>()
  const save = vi.fn(() => saving.promise)
  mount({ load: vi.fn(() => loading.promise), save })
  expect(choices().every((choice) => choice.disabled)).toBe(true)
  expect(choices().every((choice) => choice.getAttribute('aria-checked') === 'false')).toBe(true)
  await act(async () => loading.resolve('refuse'))
  expect(choices().map((choice) => choice.getAttribute('aria-checked'))).toEqual(['false', 'true'])
  act(() => { choices()[0]!.click(); choices()[0]!.click() })
  expect(save).toHaveBeenCalledTimes(1)
  expect(choices().every((choice) => choice.disabled)).toBe(true)
  await act(async () => saving.resolve())
  expect(choices().every((choice) => !choice.disabled)).toBe(true)
})

it('refuses to seat unattended work by default, and writes the other choice — never touching the watched preference', async () => {
  const save = vi.fn(async () => {})
  const saveUnattended = vi.fn(async () => {})
  mount({ save, saveUnattended })
  await act(async () => {})
  expect(unattendedChoices().map((choice) => choice.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  await act(async () => unattendedChoices()[1]!.click())
  expect(saveUnattended).toHaveBeenCalledWith('seat')
  expect(save).not.toHaveBeenCalled()
})

it('a pending unattended load or save cannot be overtaken by a click, and the watched group is unaffected', async () => {
  const loadingUnattended = deferred<UnheldCeilings>()
  const savingUnattended = deferred<void>()
  const saveUnattended = vi.fn(() => savingUnattended.promise)
  mount({ loadUnattended: vi.fn(() => loadingUnattended.promise), saveUnattended })
  expect(unattendedChoices().every((choice) => choice.disabled)).toBe(true)
  await act(async () => {})
  expect(choices().every((choice) => !choice.disabled)).toBe(true)
  await act(async () => loadingUnattended.resolve('seat'))
  expect(unattendedChoices().map((choice) => choice.getAttribute('aria-checked'))).toEqual(['false', 'true'])
  act(() => { unattendedChoices()[0]!.click(); unattendedChoices()[0]!.click() })
  expect(saveUnattended).toHaveBeenCalledTimes(1)
  await act(async () => savingUnattended.resolve())
  expect(unattendedChoices().every((choice) => !choice.disabled)).toBe(true)
})

it('is where a refusal’s fix lands: focused', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  mount({ focus: 'ceilings' })
  await act(async () => {})
  const section = document.body.querySelector<HTMLElement>('section[aria-label="Ceilings"]')
  expect(document.activeElement).toBe(section)
  expect(scroll).toHaveBeenCalledWith({ block: 'start' })
  scroll.mockClear()
  container.tabIndex = -1
  container.focus()
  mount({ focus: 'rules' })
  await act(async () => {})
  expect(document.activeElement).toBe(container)
  expect(scroll).not.toHaveBeenCalled()
  scroll.mockRestore()
})

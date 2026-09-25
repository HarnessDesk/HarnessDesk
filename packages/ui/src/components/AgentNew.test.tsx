import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, AuthoringSavePreview } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentNew } from './AgentNew'

/**
 * New Agent: from a shipped one (one `agent/copy`, no fabricated seat) or a
 * complete blank draft (writes nothing until *Create*, and never a dummy
 * `FlowSeat` just to satisfy `agent/create`).
 */
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

const BUILTIN: AgentEntry = {
  id: 'code-reviewer',
  origin: 'builtin',
  path: '/app/agents/code-reviewer/AGENT.md',
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id: 'code-reviewer', name: 'Code reviewer', description: 'Reviews a diff.', ceiling: 'read', ceilingFrom: 'ceiling',
    answers: [], produces: ['review'], skills: ['checkout-rules'], mcp: [], prefer: [], brief: 'Review the diff.',
  },
}

const COPY: AgentEntry = { ...BUILTIN, origin: 'user', id: 'code-reviewer', path: '/Users/dev/.harnessdesk/agents/code-reviewer/AGENT.md' }

const NEW_BLANK: AgentEntry = {
  id: 'new-helper',
  origin: 'user',
  path: '/Users/dev/.harnessdesk/agents/new-helper/AGENT.md',
  digest: 'd2',
  shadows: [],
  problems: [],
  definition: {
    id: 'new-helper', name: 'New helper', description: null, ceiling: 'read', ceilingFrom: 'ceiling',
    answers: [], produces: [], skills: [], mcp: [], prefer: [], brief: 'Help out.',
  },
}

const settle = () => act(async () => {})

const storeFor = (overrides: Record<string, unknown> = {}): AppStore =>
  ({
    ...emptySnapshotStore(),
    customizeAgent: vi.fn(async () => COPY),
    previewAuthoringSave: vi.fn(async (): Promise<AuthoringSavePreview> => ({ token: 'tok-1', edits: [{ path: 'agents/new-helper/AGENT.md', before: null, after: 'x' }], issues: [], resuming: false })),
    applyAuthoringSave: vi.fn(async () => ({ state: 'applied', written: ['agents/new-helper/AGENT.md'], message: 'Saved.' })),
    readAgent: vi.fn(async () => NEW_BLANK),
    loadAgents: vi.fn(async () => {}),
    ...overrides,
  }) as unknown as AppStore

function emptySnapshotStore(): { readonly subscribe: () => () => void; readonly getSnapshot: () => AppSnapshot } {
  const snapshot = { ...emptySnapshot(), agents: [BUILTIN] } as AppSnapshot
  return { subscribe: () => () => {}, getSnapshot: () => snapshot }
}

const mount = (store: AppStore, root_: string | undefined = '/repo') => {
  const onCreated = vi.fn()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AgentNew root={root_} onCreated={onCreated} onClose={onClose} />
      </StoreProvider>,
    )
  })
  return { onCreated, onClose }
}

const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button “${label}”`)
  return found
}
// `RowChoice` concatenates its title and description into one button's text
// (`role="radio"`), so a choice row is matched by its title's start, not by
// an exact match the way a plain `Button`'s own label is.
const choice = (title: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button[role="radio"]')].find((one) => one.textContent?.startsWith(title))
  if (!found) throw new Error(`no choice “${title}”`)
  return found as HTMLButtonElement
}
const input = (labelText: string): HTMLInputElement | HTMLTextAreaElement => {
  const label = [...document.body.querySelectorAll('label')].find((one) => one.textContent?.trim() === labelText)
  const id = label?.getAttribute('for')
  const found = id ? document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${CSS.escape(id)}`) : null
  if (!found) throw new Error(`no field “${labelText}”`)
  return found
}
const type = async (control: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  const proto = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('a blank draft writes nothing while typing, and cancels with no calls at all', async () => {
  const store = storeFor()
  const { onClose } = mount(store)

  act(() => choice('A blank Agent').click())
  await settle()
  await type(input('Name'), 'New helper')
  await type(input('Brief'), 'Help out.')
  await settle()

  expect(store.previewAuthoringSave).not.toHaveBeenCalled()
  expect(store.applyAuthoringSave).not.toHaveBeenCalled()

  act(() => button('Cancel').click())
  expect(onClose).toHaveBeenCalled()
  expect(store.previewAuthoringSave).not.toHaveBeenCalled()
})

it('a complete blank draft previews and applies exactly one file on Create', async () => {
  const store = storeFor()
  const { onCreated } = mount(store)

  act(() => choice('A blank Agent').click())
  await settle()
  await type(input('Name'), 'New helper')
  await type(input('Brief'), 'Help out.')
  await settle()

  act(() => button('Create').click())
  await settle()

  expect(store.previewAuthoringSave).toHaveBeenCalledTimes(1)
  const call = (store.previewAuthoringSave as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
    readonly target: { readonly kind: string; readonly origin: string; readonly id: string }
    readonly expected: unknown
  }
  // A project is open, so the default scope is the project's own — matching
  // the existing Customize… dialog's own default of "wherever it comes
  // first" among the available targets.
  expect(call.target).toMatchObject({ kind: 'agent', origin: 'project', id: 'new-helper', root: '/repo' })
  expect(call.expected).toBeNull()
  expect(store.applyAuthoringSave).toHaveBeenCalledWith('tok-1')
  expect(onCreated).toHaveBeenCalledWith(NEW_BLANK)
})

it('the blank Agent’s fields sit inside a card, and the Ceiling choices read in words, never the raw four levels', async () => {
  const store = storeFor()
  mount(store)

  act(() => choice('A blank Agent').click())
  await settle()

  expect(input('Name').closest('[data-slot="card"]')).not.toBeNull()

  const ceilingSelect = [...document.body.querySelectorAll('select')].find((one) =>
    [...one.options].some((opt) => opt.value === 'read'),
  )!
  const optionText = [...ceilingSelect.options].map((one) => one.textContent?.trim())
  expect(optionText).toEqual(['Read', 'Edit', 'Publish', 'Merge'])
  expect(optionText).not.toContain('read')
})

it('a template copies through agent/copy once, before any edit — no synthesized clone', async () => {
  const store = storeFor()
  const { onCreated } = mount(store)

  // The template row is the default choice when builtins exist; confirm it directly.
  act(() => button('Copy and open').click())
  await settle()

  expect(store.customizeAgent).toHaveBeenCalledTimes(1)
  expect(store.customizeAgent).toHaveBeenCalledWith('code-reviewer', 'builtin', expect.any(String))
  expect(store.previewAuthoringSave).not.toHaveBeenCalled()
  expect(onCreated).toHaveBeenCalledWith(COPY)
})

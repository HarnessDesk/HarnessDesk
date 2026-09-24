import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, AuthoringDocument, AuthoringSavePreview } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import type { AppStore } from '../state/store'
import { AgentFields } from './AgentFields'

/**
 * Task 5's editable Agent metadata: one field, previewed then saved, never
 * more than the row a person touched. Ceiling and `prefer` stay out of this
 * file's own scope (their existing sections and the legacy-permission
 * `Update…` flow are untouched); this covers name, description, answers and
 * produces.
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

const ENTRY: AgentEntry = {
  id: 'reviewer',
  origin: 'user',
  path: '/Users/dev/.harnessdesk/agents/reviewer/AGENT.md',
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reads the diff.',
    ceiling: 'read',
    ceilingFrom: 'ceiling',
    answers: ['approve', 'request-changes'],
    produces: ['review'],
    skills: [],
    mcp: [],
    prefer: [],
    brief: 'Read the diff.',
  },
}

const DOCUMENT: AuthoringDocument = {
  target: { kind: 'agent', origin: 'user', id: 'reviewer' },
  source: '---\nname: Reviewer\ndescription: Reads the diff.\n---\nRead the diff.\n',
  digest: 'digest-1',
  exists: true,
  displayPath: 'agents/reviewer/AGENT.md',
  writable: true,
  issues: [],
}

const settle = () => act(async () => {})

const storeFor = (overrides: Record<string, unknown> = {}): AppStore =>
  ({
    previewAgentEdit: vi.fn(async (): Promise<AuthoringSavePreview> => ({ token: null, edits: [], issues: [], resuming: false })),
    applyAuthoringSave: vi.fn(async () => ({ state: 'applied', written: ['agents/reviewer/AGENT.md'], message: 'Saved.' })),
    readAuthoring: vi.fn(async () => DOCUMENT),
    ...overrides,
  }) as unknown as AppStore

const mount = (store: AppStore, doc: AuthoringDocument = DOCUMENT) => {
  const onEdit = vi.fn()
  const onOpenFile = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AgentFields document={doc} entry={ENTRY} busy={false} onEdit={onEdit} onOpenFile={onOpenFile} />
      </StoreProvider>,
    )
  })
  return { onEdit, onOpenFile }
}

const editButtonFor = (label: string): HTMLButtonElement => {
  const row = [...container.querySelectorAll('[data-slot="row"], div, section')]
    .find((el) => el.textContent?.startsWith(label) && el.querySelector('button'))
  const found = row?.querySelector('button') as HTMLButtonElement | undefined
  if (!found) throw new Error(`no Edit… button for “${label}”`)
  return found
}

// The dialog portals to `document.body`.
const dialogInput = (): HTMLInputElement | HTMLTextAreaElement => {
  const found = document.body.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null
  if (!found) throw new Error('no field control in the open dialog')
  return found
}
const dialogButton = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no dialog button “${label}”`)
  return found
}

const type = async (control: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  const proto = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('one key produces one previewed patch, bound to the original digest, then an explicit apply', async () => {
  const preview: AuthoringSavePreview = {
    token: 'tok-1',
    edits: [{ path: 'agents/reviewer/AGENT.md', before: DOCUMENT.source, after: '---\nname: Reviewer\ndescription: New words.\n---\nRead the diff.\n' }],
    issues: [],
    resuming: false,
  }
  const previewAgentEdit = vi.fn(async (_target: unknown, _expected: string, _edit: unknown) => preview)
  const store = storeFor({ previewAgentEdit })
  const { onEdit } = mount(store)

  act(() => editButtonFor('Description').click())
  await settle()
  await type(dialogInput(), 'New words.')
  await settle()

  expect(previewAgentEdit).toHaveBeenLastCalledWith(
    { kind: 'agent', origin: 'user', id: 'reviewer' },
    'digest-1',
    { key: 'description', value: 'New words.' },
  )
  // Every call previewed exactly one field — never name and description together.
  for (const call of previewAgentEdit.mock.calls) {
    expect(Object.keys(call[2] as object)).toEqual(['key', 'value'])
  }

  act(() => dialogButton('Save').click())
  await settle()

  expect(store.applyAuthoringSave).toHaveBeenCalledWith('tok-1')
  expect(onEdit).toHaveBeenCalledWith({ key: 'description', value: 'New words.' })
})

it('a field that spans lines in the file refuses with Open file, keeping the row visible', async () => {
  const previewAgentEdit = vi.fn(async () => ({
    token: null,
    edits: [],
    issues: [{ at: 'description', text: 'This field spans lines. Open the file to preserve its formatting.', fix: 'Open the file to change it there.' }],
    resuming: false,
  }))
  const store = storeFor({ previewAgentEdit })
  const { onOpenFile } = mount(store)

  act(() => editButtonFor('Description').click())
  await settle()

  expect(document.body.textContent).toContain('This field spans lines')
  expect(dialogInput()).not.toBeNull()
  act(() => dialogButton('Open file').click())
  expect(onOpenFile).toHaveBeenCalled()
  // Never offered as savable: no token means Save stays disabled.
  expect(dialogButton('Save').hasAttribute('disabled')).toBe(true)
})

it('a stale-file conflict keeps the typed value, offers Reload, and never auto-retries the apply', async () => {
  let expected = 'digest-1'
  const previewAgentEdit = vi.fn(async (_target: unknown, digest: string): Promise<AuthoringSavePreview> =>
    digest === expected
      ? { token: 'tok-2', edits: [{ path: 'agents/reviewer/AGENT.md', before: DOCUMENT.source, after: 'after' }], issues: [], resuming: false }
      : { token: null, edits: [], issues: [{ at: 'description', text: 'The file changed. Reload before saving.', fix: 'Reload the Agent, then make this change again.' }], resuming: false })
  const readAuthoring = vi.fn(async () => ({ ...DOCUMENT, digest: 'digest-2' }))
  const applyAuthoringSave = vi.fn()
  const store = storeFor({ previewAgentEdit, readAuthoring, applyAuthoringSave })
  mount(store)

  act(() => editButtonFor('Description').click())
  await settle()
  // Somebody else's save landed first: this row's own preview now reads stale.
  expected = 'digest-2'
  await type(dialogInput(), 'Mine, typed here.')
  await settle()

  expect(document.body.textContent).toContain('The file changed')
  expect((dialogInput() as HTMLInputElement).value).toBe('Mine, typed here.')
  expect(applyAuthoringSave).not.toHaveBeenCalled()

  act(() => dialogButton('Reload').click())
  await settle()

  expect(readAuthoring).toHaveBeenCalled()
  // Still not applied on its own — the person must press Save again.
  expect(applyAuthoringSave).not.toHaveBeenCalled()
  expect((dialogInput() as HTMLInputElement).value).toBe('Mine, typed here.')

  act(() => dialogButton('Save').click())
  await settle()
  expect(applyAuthoringSave).toHaveBeenCalledWith('tok-2')
})

it('a built-in Agent shows the same rows with no Edit…', () => {
  const store = storeFor()
  const builtin: AgentEntry = { ...ENTRY, origin: 'builtin' }
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AgentFields document={DOCUMENT} entry={builtin} busy={false} onEdit={() => {}} onOpenFile={() => {}} />
      </StoreProvider>,
    )
  })
  expect(container.textContent).toContain('Reviewer')
  expect([...container.querySelectorAll('button')].some((one) => one.textContent?.includes('Edit…'))).toBe(false)
})

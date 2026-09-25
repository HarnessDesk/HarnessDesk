import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentAttachmentsView, AgentEntry } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentAttachments } from './AgentAttachments'

/**
 * Task 5's editable replacement for the old read-only Skills row: an empty
 * allowlist reads "Runtime defaults", never "None", and editing is strictly
 * a preview-then-write pair — it never approves or starts anything on its
 * own, which is the one thing decision 10 insists loading consent must stay
 * separate from.
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
    name: 'Reviewer',
    description: '',
    brief: 'Read the diff.',
    ceiling: 'read',
    ceilingFrom: 'ceiling',
    permission: 'read',
    answers: [],
    produces: [],
    skills: [],
    mcp: [],
    prefer: [],
  } as unknown as AgentEntry['definition'],
}

const settle = () => act(async () => {})

const SNAPSHOT = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot

const storeFor = (view: AgentAttachmentsView, overrides: Record<string, unknown> = {}): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: () => SNAPSHOT,
    readAgentAttachments: vi.fn(async () => view),
    previewAttachmentEdit: vi.fn(async () => ({ path: ENTRY.path, digest: 'd', diff: '@@ -1,1 +1,1 @@\n-skills: []\n+skills: [x]\n' })),
    writeAttachmentEdit: vi.fn(async (entry: AgentEntry) => entry),
    ...overrides,
  }) as unknown as AppStore

const emptyView: AgentAttachmentsView = {
  agent: 'reviewer',
  origin: 'user',
  agentDigest: 'd',
  skillsMode: 'runtime-defaults',
  mcpMode: 'runtime-defaults',
  declarations: [],
  support: [],
}

it('defaults are not none: an empty allowlist reads "Runtime defaults"', async () => {
  const store = storeFor(emptyView)
  act(() => root.render(<StoreProvider store={store}><AgentAttachments entry={ENTRY} /></StoreProvider>))
  await settle()
  const text = container.textContent ?? ''
  expect(text).toContain('Runtime defaults')
  expect(text).not.toContain('None')
})

it('a declared name with an unresolved problem stays visible with its own reason', async () => {
  const view: AgentAttachmentsView = {
    ...emptyView,
    skillsMode: 'allowlist',
    declarations: [{ kind: 'skill', name: 'ambiguous-one', identity: null, problem: 'Two Library copies disagree; choose one.' }],
  }
  const store = storeFor(view)
  act(() => root.render(<StoreProvider store={store}><AgentAttachments entry={ENTRY} /></StoreProvider>))
  await settle()
  expect(container.textContent ?? '').toContain('ambiguous-one')
})

it('editing calls preview then write only — never an approve or a start call', async () => {
  const view: AgentAttachmentsView = {
    ...emptyView,
    skillsMode: 'allowlist',
    declarations: [{ kind: 'skill', name: 'review-checklist', identity: { kind: 'skill', name: 'review-checklist', digest: 'd'.repeat(64), source: 'library', pathLabel: '~/review-checklist' }, problem: null }],
  }
  const approve = vi.fn()
  const startAsAgent = vi.fn()
  const store = storeFor(view, { approve, startAsAgent })
  act(() => root.render(<StoreProvider store={store}><AgentAttachments entry={ENTRY} /></StoreProvider>))
  await settle()

  const editButton = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Edit…')
  expect(editButton).toBeTruthy()
  act(() => editButton!.click())
  await settle()

  const checkbox = document.body.querySelector('input[type="checkbox"], [role="checkbox"]') as HTMLElement | null
  expect(checkbox).toBeTruthy()
  act(() => checkbox!.click())
  await settle()

  const saveButton = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Save')
  expect(saveButton).toBeTruthy()
  act(() => saveButton!.click())
  await settle()

  expect(store.previewAttachmentEdit).toHaveBeenCalled()
  expect(store.writeAttachmentEdit).toHaveBeenCalled()
  expect(approve).not.toHaveBeenCalled()
  expect(startAsAgent).not.toHaveBeenCalled()
})

it('a built-in Agent offers no Edit control at all', async () => {
  const builtinEntry: AgentEntry = { ...ENTRY, origin: 'builtin' }
  const store = storeFor({ ...emptyView, origin: 'builtin' })
  act(() => root.render(<StoreProvider store={store}><AgentAttachments entry={builtinEntry} /></StoreProvider>))
  await settle()
  const editButton = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Edit…')
  expect(editButton).toBeUndefined()
})

it('review asks the host for the Seat’s own runtime and names it by its presentation name, never an id', async () => {
  const view: AgentAttachmentsView = {
    ...emptyView,
    skillsMode: 'allowlist',
    declarations: [{ kind: 'skill', name: 'review-checklist', identity: { kind: 'skill', name: 'review-checklist', digest: 'd'.repeat(64), source: 'library', pathLabel: '~/review-checklist' }, problem: null }],
    // The first capable runtime listed is not the one this Agent is seated on.
    support: [
      { runtime: 'first-capable-id', build: '1', skills: 'scoped', mcp: 'unsupported', suppressUnapproved: true, reason: null },
      { runtime: 'seat-runtime-id', build: '2', skills: 'scoped', mcp: 'scoped-gated', suppressUnapproved: true, reason: null },
    ],
  }
  const snapshot = {
    ...SNAPSHOT,
    workspace: { name: 'demo', path: '/work/demo' },
    runtimes: [
      { id: 'first-capable-id', presentation: { name: 'First Agent' } },
      { id: 'seat-runtime-id', presentation: { name: 'Seat Agent' } },
    ],
  } as unknown as AppSnapshot
  const reviewAttachments = vi.fn(async () => ({
    token: 't', expiresAt: 0, declarations: view.declarations, files: [], runtime: 'seat-runtime-id', effectiveCeiling: 'merge', consequence: 'c', hidden: [],
  }))
  const store = { ...storeFor(view, { reviewAttachments }), getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><AgentAttachments entry={ENTRY} /></StoreProvider>))
  await settle()
  expect(container.textContent ?? '').not.toContain('first-capable-id')

  const review = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.includes('Review'))
  expect(review).toBeTruthy()
  act(() => review!.click())
  await settle()

  expect(reviewAttachments).toHaveBeenCalledWith('reviewer', 'user', '/work/demo')
  const text = document.body.textContent ?? ''
  expect(text).toContain('Seat Agent')
  expect(text).not.toContain('seat-runtime-id')
  expect(text).not.toContain('First Agent')
})

it('the review is not a destructive confirm, and Approve waits for the review it approves', async () => {
  const view: AgentAttachmentsView = {
    ...emptyView,
    skillsMode: 'allowlist',
    declarations: [{ kind: 'skill', name: 'review-checklist', identity: { kind: 'skill', name: 'review-checklist', digest: 'd'.repeat(64), source: 'library', pathLabel: '~/review-checklist' }, problem: null }],
    support: [{ runtime: 'seat-runtime-id', build: '2', skills: 'scoped', mcp: 'scoped-gated', suppressUnapproved: true, reason: null }],
  }
  const snapshot = { ...SNAPSHOT, workspace: { name: 'demo', path: '/work/demo' }, runtimes: [{ id: 'seat-runtime-id', presentation: { name: 'Seat Agent' } }] } as unknown as AppSnapshot
  let answer: (review: unknown) => void = () => {}
  const reviewAttachments = vi.fn(() => new Promise((resolve) => { answer = resolve }))
  const approveAttachments = vi.fn(async () => {})
  const store = { ...storeFor(view, { reviewAttachments, approveAttachments }), getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><AgentAttachments entry={ENTRY} /></StoreProvider>))
  await settle()
  act(() => [...document.body.querySelectorAll('button')].find((one) => one.textContent?.includes('Review'))!.click())
  await settle()

  const surface = document.querySelector<HTMLElement>('[role="alertdialog"]')!
  const approve = () => [...surface.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Approve')!
  expect(approve().disabled).toBe(true)
  act(() => approve().click())
  expect(approveAttachments).not.toHaveBeenCalled()
  expect(surface.querySelector('[data-slot="alert-dialog-header"]')?.getAttribute('data-tone')).toBeNull()
  expect(approve().getAttribute('data-variant')).not.toBe('destructive')

  await act(async () => { answer({ token: 't', expiresAt: 0, declarations: view.declarations, files: [], runtime: 'seat-runtime-id', effectiveCeiling: 'merge', consequence: 'c', hidden: [] }) })
  expect(approve().disabled).toBe(false)
})

/*
 * #895. A server's value whose name looks like a credential is shown only as
 * set, and a value that changes what the server does can hide behind such a
 * name. Approving such a review asks the person to say they know what those
 * values are, and says so to the host.
 */
it('a review with values shown only as set is approved only once the person says they know them', async () => {
  const view: AgentAttachmentsView = {
    ...emptyView,
    mcpMode: 'allowlist',
    declarations: [{ kind: 'mcp', name: 'tools', identity: { kind: 'mcp', name: 'tools', digest: 'e'.repeat(64), source: 'library', pathLabel: '~/tools' }, problem: null }],
    support: [{ runtime: 'seat-runtime-id', build: '2', skills: 'scoped', mcp: 'scoped-gated', suppressUnapproved: true, reason: null }],
  }
  const snapshot = { ...SNAPSHOT, workspace: { name: 'demo', path: '/work/demo' }, runtimes: [{ id: 'seat-runtime-id', presentation: { name: 'Seat Agent' } }] } as unknown as AppSnapshot
  const reviewAttachments = vi.fn(async () => ({
    token: 't', expiresAt: 0, declarations: view.declarations, files: [], runtime: 'seat-runtime-id', effectiveCeiling: 'merge', consequence: 'c', hidden: ['tools: SESSION_MODE'],
  }))
  const approveAttachments = vi.fn(async () => {})
  const store = { ...storeFor(view, { reviewAttachments, approveAttachments }), getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><AgentAttachments entry={ENTRY} /></StoreProvider>))
  await settle()
  act(() => [...document.body.querySelectorAll('button')].find((one) => one.textContent?.includes('Review'))!.click())
  await settle()

  const surface = document.querySelector<HTMLElement>('[role="alertdialog"]')!
  expect(surface.textContent).toContain('tools: SESSION_MODE')
  const approve = () => [...surface.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Approve')!
  expect(approve().disabled).toBe(true)
  const box = surface.querySelector<HTMLElement>('[aria-label="I know what the hidden values are"]')!
  expect(box).toBeTruthy()
  act(() => box.click())
  await settle()
  expect(approve().disabled).toBe(false)
  act(() => approve().click())
  await settle()
  expect(approveAttachments).toHaveBeenCalledWith('t', true)
})

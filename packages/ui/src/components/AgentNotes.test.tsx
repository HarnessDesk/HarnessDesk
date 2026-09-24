import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, AgentNotesView } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentNotes } from './AgentNotes'

/**
 * `NOTES.md`, read and cleared from the Agent page. Rendered through the
 * same sanitized Markdown every transcript uses — this is committed prose
 * from a repository, exactly as untrusted as any of it — and cleared only by
 * an explicit confirm naming the file, never by the row itself.
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
  definition: { name: 'Reviewer' } as unknown as AgentEntry['definition'],
}

const settle = () => act(async () => {})

const SNAPSHOT = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot

const storeFor = (view: AgentNotesView, overrides: Record<string, unknown> = {}): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: () => SNAPSHOT,
    readAgentNotes: vi.fn(async () => view),
    clearAgentNotes: vi.fn(async () => ({ ...view, text: '', digest: 'e'.repeat(64) })),
    ...overrides,
  }) as unknown as AppStore

it('a missing notes file says so, and offers no Clear control', async () => {
  const store = storeFor({ path: '/NOTES.md', text: null, digest: null, writable: true, problem: null })
  act(() => root.render(<StoreProvider store={store}><AgentNotes entry={ENTRY} /></StoreProvider>))
  await settle()
  const text = container.textContent ?? ''
  expect(text).toContain('no notes')
  expect([...document.body.querySelectorAll('button')].some((one) => one.textContent?.includes('Clear'))).toBe(false)
})

it('untrusted notes cannot execute a script or auto-navigate — sanitized like any other Markdown', async () => {
  const hostile = '<script>window.__pwned = true</script>[click me](javascript:alert(1))\n\n<img src=x onerror="window.__pwned = true">'
  const store = storeFor({ path: '/NOTES.md', text: hostile, digest: 'd'.repeat(64), writable: true, problem: null })
  act(() => root.render(<StoreProvider store={store}><AgentNotes entry={ENTRY} /></StoreProvider>))
  await settle()
  expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined()
  expect(container.querySelector('script')).toBeNull()
  const link = container.querySelector('a[href^="javascript:"]')
  expect(link).toBeNull()
})

it('Clear opens a confirmation naming the file, and only actually clears on explicit confirm', async () => {
  const store = storeFor({ path: '/Users/dev/.harnessdesk/agents/reviewer/NOTES.md', text: 'Prefer small diffs.', digest: 'd'.repeat(64), writable: true, problem: null })
  act(() => root.render(<StoreProvider store={store}><AgentNotes entry={ENTRY} /></StoreProvider>))
  await settle()

  const clearButton = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim().startsWith('Clear'))
  expect(clearButton).toBeTruthy()
  act(() => clearButton!.click())
  await settle()
  expect(store.clearAgentNotes).not.toHaveBeenCalled()
  expect(document.body.textContent ?? '').toContain('NOTES.md')

  const confirmButton = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Clear notes')
  expect(confirmButton).toBeTruthy()
  act(() => confirmButton!.click())
  await settle()
  expect(store.clearAgentNotes).toHaveBeenCalledWith('reviewer', 'user', 'd'.repeat(64))
})
